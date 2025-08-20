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
      if (result.confidence < 0.5 || result.intent === 'address_confirmation') {
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
    if (lowerMessage.startsWith('add') || lowerMessage.includes('add') || lowerMessage.includes('include') || lowerMessage.includes('more')) {
      return {
        intent: 'add_item',
        items: this.extractItemsFromText(message),
        confidence: 0.9
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

    // Check for show prices
    if (lowerMessage.includes('show price') || lowerMessage.includes('price') || lowerMessage.includes('prices')) {
      return {
        intent: 'show_prices',
        confidence: 0.9
      };
    }

    // Check for show cart
    if (lowerMessage.includes('show cart') || lowerMessage.includes('view cart') || lowerMessage.includes('cart')) {
      return {
        intent: 'show_cart',
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
      
      console.log(`📍 Detected address: ${address}`);
      
      return {
        intent: 'order',
        items: [],
        address: address,
        confidence: 0.9
      };
    }

    // Check for authentication intent (e.g., "login zepto", "connect blinkit", "auth instamart")
    if (lowerMessage.includes('login') || lowerMessage.includes('connect') || lowerMessage.includes('auth') || 
        lowerMessage.includes('sign in') || lowerMessage.includes('signin')) {
      return {
        intent: 'authentication',
        retailer: this.extractRetailerFromAuth(message),
        confidence: 0.9
      };
    }

    // Check for product selection (e.g., "1 for milk", "2 for bread", "Zepto 1 for milk")
    if ((/\d/.test(lowerMessage) && lowerMessage.includes('for')) || 
        ((lowerMessage.includes('zepto') || lowerMessage.includes('blinkit') || lowerMessage.includes('instamart')) && 
         /\d/.test(lowerMessage) && lowerMessage.includes('for'))) {
      return {
        intent: 'product_selection',
        choices: this.extractProductChoices(message),
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
   * Extract retailer from authentication message
   * @param {string} message - User message
   * @returns {string|null} - Retailer name or null
   */
  extractRetailerFromAuth(message) {
    const lowerMessage = message.toLowerCase();
    const retailers = ['zepto', 'blinkit', 'instamart', 'swiggy'];
    
    for (const retailer of retailers) {
      if (lowerMessage.includes(retailer)) {
        return retailer;
      }
    }
    
    return null;
  }

  /**
   * Extract product choices from message
   * @param {string} message - User message
   * @returns {Object} - Product choices
   */
  extractProductChoices(message) {
    const choices = {};
    const lowerMessage = message.toLowerCase();
    
    // Extract items from the message
    const items = this.extractItemsFromText(message);
    
    // Extract product number (e.g., "1", "2", "3")
    const numberMatch = lowerMessage.match(/(\d+)/);
    const productNumber = numberMatch ? parseInt(numberMatch[1]) : 1;
    
    // Check if specific retailer is mentioned
    const retailers = ['zepto', 'blinkit', 'instamart'];
    let specifiedRetailer = null;
    
    retailers.forEach(retailer => {
      if (lowerMessage.includes(retailer)) {
        specifiedRetailer = retailer.charAt(0).toUpperCase() + retailer.slice(1);
      }
    });
    
    // Map items to choices
    items.forEach(item => {
      choices[item.name] = {
        productNumber: productNumber,
        retailer: specifiedRetailer // Will be null if no specific retailer mentioned
      };
    });
    
    return choices;
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
      // First try multi-word items (like "peanut butter")
      const multiWordItems = text.match(/\b(peanut butter|chocolate milk|whole wheat bread|brown bread|white bread|fresh milk|skim milk|full cream milk|olive oil|coconut oil|sunflower oil|vanilla ice cream|chocolate ice cream|strawberry ice cream|green tea|black tea|coffee powder|sugar free|low fat|organic|fresh|frozen)\b/gi);
      if (multiWordItems) {
        multiWordItems.forEach(item => {
          items.push({
            name: item.toLowerCase(),
            quantity: 1,
            unit: 'pc'
          });
        });
      }
      
      // Then try single word items
      const simpleItems = text.match(/\b(milk|bread|eggs|tomatoes|onions|potatoes|rice|sugar|salt|oil|butter|cheese|yogurt|fruits|vegetables|apple|banana|orange|mango|grapes|carrot|cucumber|lettuce|spinach|chicken|fish|meat|paneer|tofu|noodles|pasta|sauce|ketchup|mayonnaise|jam|honey|chocolate|biscuits|cookies|cake|ice cream|juice|soda|water|tea|coffee|chips|snacks|wafers|nuts|almonds|cashews|raisins|dates|prunes|dried fruits|fresh fruits|fresh vegetables|frozen vegetables|frozen fruits|ice cream|chocolate|candy|sweets|biscuits|cookies|crackers|namkeen|mixture|chivda|sev|papad|pickle|chutney|sauce|ketchup|mayonnaise|mustard|vinegar|oil|ghee|butter|cheese|paneer|tofu|meat|chicken|fish|eggs|milk|curd|yogurt|bread|roti|naan|paratha|rice|dal|lentils|pulses|flour|atta|maida|sugar|salt|spices|masala|tea|coffee|juice|soda|water|beverages|drinks)\b/gi);
      if (simpleItems) {
        simpleItems.forEach(item => {
          // Skip if already added as multi-word item
          if (!items.some(existing => existing.name.includes(item.toLowerCase()))) {
            items.push({
              name: item.toLowerCase(),
              quantity: 1,
              unit: 'pc'
            });
          }
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
    const hasAddressPattern = /^[A-Z0-9\-\/,\s]+$/i.test(message.trim()) && message.length > 10 && !lowerMessage.includes('show') && !lowerMessage.includes('price');
    
    // Check for address-like structure (contains numbers and city names)
    const hasAddressStructure = /\d+/.test(message) && addressKeywords.some(keyword => lowerMessage.includes(keyword));
    
    // Check if message contains "address" keyword
    const hasAddressKeyword = lowerMessage.includes('address');
    
    // Check for specific patterns like "B-102" (building numbers)
    const hasBuildingNumber = /[A-Z]-\d+/.test(message);
    
    // Check for apartment/unit patterns
    const hasUnitPattern = /(flat|apartment|unit|room)\s*\d+/i.test(message);
    
    const isAddress = hasPincode || hasAddressKeywords || hasAddressPattern || hasAddressStructure || hasAddressKeyword || hasBuildingNumber || hasUnitPattern;
    
    console.log(`🔍 Address detection for "${message}":`, {
      hasPincode,
      hasAddressKeywords,
      hasAddressPattern,
      hasAddressStructure,
      hasAddressKeyword,
      hasBuildingNumber,
      hasUnitPattern,
      isAddress
    });
    
    return isAddress;
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
   * Reverse geocode coordinates to get address using Google Maps API
   * @param {number} latitude - Latitude coordinate
   * @param {number} longitude - Longitude coordinate
   * @returns {Promise<Object|null>} - Address object or null
   */
  async reverseGeocode(latitude, longitude) {
    try {
      console.log(`📍 Reverse geocoding: ${latitude}, ${longitude}`);

      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          latlng: `${latitude},${longitude}`,
          key: process.env.GOOGLE_MAPS_API_KEY,
          region: 'in' // Bias towards India
        }
      });

      if (response.data.status === 'OK' && response.data.results.length > 0) {
        const result = response.data.results[0];
        
        // Extract components
        const components = {};
        result.address_components.forEach(component => {
          const types = component.types;
          if (types.includes('street_number')) components.street_number = component.long_name;
          if (types.includes('route')) components.route = component.long_name;
          if (types.includes('locality')) components.city = component.long_name;
          if (types.includes('administrative_area_level_1')) components.state = component.long_name;
          if (types.includes('postal_code')) components.pincode = component.long_name;
          if (types.includes('country')) components.country = component.long_name;
        });

        return {
          formatted: result.formatted_address,
          latitude: latitude,
          longitude: longitude,
          components: components,
          pincode: components.pincode
        };
      }

      return null;
    } catch (error) {
      console.error('❌ Error reverse geocoding:', error);
      return null;
    }
  }

  /**
   * Get price suggestions for items (real scraping for Phase 1)
   * @param {Array} items - Array of items
   * @param {string} pincode - Delivery pincode
   * @returns {Promise<Array>} - Price suggestions
   */
  async getPriceSuggestions(items, pincode) {
    const suggestions = [];
    
    for (const item of items) {
      try {
        console.log(`🔍 Scraping prices for: ${item.name} in pincode: ${pincode}`);
        
        // Scrape real prices from multiple platforms
        const [zeptoPrice, blinkitPrice, instamartPrice] = await Promise.allSettled([
          this.scrapeZeptoPrice(item.name, pincode),
          this.scrapeBlinkitPrice(item.name, pincode),
          this.scrapeInstamartPrice(item.name, pincode)
        ]);

        const prices = [];
        
        // Add Zepto price if available
        if (zeptoPrice.status === 'fulfilled' && zeptoPrice.value) {
          prices.push({
            retailer: 'Zepto',
            price: zeptoPrice.value.price,
            delivery_time: zeptoPrice.value.delivery_time || '10 min',
            in_stock: zeptoPrice.value.in_stock !== false
          });
        }

        // Add Blinkit price if available
        if (blinkitPrice.status === 'fulfilled' && blinkitPrice.value) {
          prices.push({
            retailer: 'Blinkit',
            price: blinkitPrice.value.price,
            delivery_time: blinkitPrice.value.delivery_time || '9 min',
            in_stock: blinkitPrice.value.in_stock !== false
          });
        }

        // Add Instamart price if available
        if (instamartPrice.status === 'fulfilled' && instamartPrice.value) {
          prices.push({
            retailer: 'Instamart',
            price: instamartPrice.value.price,
            delivery_time: instamartPrice.value.delivery_time || '15 min',
            in_stock: instamartPrice.value.in_stock !== false
          });
        }

        // If no real prices found, use fallback mock prices
        if (prices.length === 0) {
          console.log(`⚠️ No real prices found for ${item.name}, using fallback prices`);
          prices.push(
            { retailer: 'Zepto', price: 55, delivery_time: '10 min', in_stock: true },
            { retailer: 'Blinkit', price: 58, delivery_time: '9 min', in_stock: true },
            { retailer: 'Instamart', price: 56, delivery_time: '15 min', in_stock: true }
          );
        }

        suggestions.push({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          prices: prices
        });

      } catch (error) {
        console.error(`❌ Error scraping prices for ${item.name}:`, error);
        
        // Fallback to mock prices if scraping fails
        suggestions.push({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          prices: [
            { retailer: 'Zepto', price: 55, delivery_time: '10 min', in_stock: true },
            { retailer: 'Blinkit', price: 58, delivery_time: '9 min', in_stock: true },
            { retailer: 'Instamart', price: 56, delivery_time: '15 min', in_stock: true }
          ]
        });
      }
    }

    return suggestions;
  }

  /**
   * Scrape price from Zepto
   * @param {string} itemName - Item name
   * @param {string} pincode - Delivery pincode
   * @returns {Promise<Object|null>} - Price data or null
   */
  async scrapeZeptoPrice(itemName, pincode) {
    try {
      const searchUrl = `https://www.zepto.in/search?q=${encodeURIComponent(itemName)}`;
      
      // For Phase 1, we'll use a simple approach
      // In production, this would use Playwright/Puppeteer for real scraping
      
      // Try to get real price from Zepto API or scrape the page
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      // Parse the HTML to extract price information
      const html = response.data;
      
      // Look for price patterns in the HTML
      const pricePatterns = [
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g,
        /price["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi,
        /"price"["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi
      ];

      let foundPrice = null;
      for (const pattern of pricePatterns) {
        const matches = html.match(pattern);
        if (matches && matches.length > 0) {
          // Find the first reasonable price (between 10 and 1000)
          for (const match of matches) {
            const price = parseFloat(match.replace(/[^\d.]/g, ''));
            if (price >= 10 && price <= 1000) {
              foundPrice = price;
              break;
            }
          }
          if (foundPrice) break;
        }
      }

      if (foundPrice) {
        console.log(`🔍 Zepto real price for ${itemName}: ₹${foundPrice}`);
        return {
          price: foundPrice,
          delivery_time: '10 min',
          in_stock: true,
          search_url: searchUrl
        };
      }

      console.log(`🔍 Zepto scraping failed for ${itemName}, showing N/A`);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    } catch (error) {
      console.error('❌ Error scraping Zepto:', error.message);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    }
  }

  /**
   * Scrape price from Blinkit
   * @param {string} itemName - Item name
   * @param {string} pincode - Delivery pincode
   * @returns {Promise<Object|null>} - Price data or null
   */
  async scrapeBlinkitPrice(itemName, pincode) {
    try {
      const searchUrl = `https://blinkit.com/s/?q=${encodeURIComponent(itemName)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      const html = response.data;
      
      // Look for price patterns in the HTML
      const pricePatterns = [
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g,
        /price["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi,
        /"price"["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi
      ];

      let foundPrice = null;
      for (const pattern of pricePatterns) {
        const matches = html.match(pattern);
        if (matches && matches.length > 0) {
          for (const match of matches) {
            const price = parseFloat(match.replace(/[^\d.]/g, ''));
            if (price >= 10 && price <= 1000) {
              foundPrice = price;
              break;
            }
          }
          if (foundPrice) break;
        }
      }

      if (foundPrice) {
        console.log(`🔍 Blinkit real price for ${itemName}: ₹${foundPrice}`);
        return {
          price: foundPrice,
          delivery_time: '9 min',
          in_stock: true,
          search_url: searchUrl
        };
      }

      console.log(`🔍 Blinkit scraping failed for ${itemName}, showing N/A`);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    } catch (error) {
      console.error('❌ Error scraping Blinkit:', error.message);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    }
  }

  /**
   * Scrape price from Swiggy Instamart
   * @param {string} itemName - Item name
   * @param {string} pincode - Delivery pincode
   * @returns {Promise<Object|null>} - Price data or null
   */
  async scrapeInstamartPrice(itemName, pincode) {
    try {
      const searchUrl = `https://www.swiggy.com/instamart?query=${encodeURIComponent(itemName)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      const html = response.data;
      
      // Look for price patterns in the HTML
      const pricePatterns = [
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g,
        /price["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi,
        /"price"["\s]*:["\s]*(\d+(?:\.\d{2})?)/gi
      ];

      let foundPrice = null;
      for (const pattern of pricePatterns) {
        const matches = html.match(pattern);
        if (matches && matches.length > 0) {
          for (const match of matches) {
            const price = parseFloat(match.replace(/[^\d.]/g, ''));
            if (price >= 10 && price <= 1000) {
              foundPrice = price;
              break;
            }
          }
          if (foundPrice) break;
        }
      }

      if (foundPrice) {
        console.log(`🔍 Instamart real price for ${itemName}: ₹${foundPrice}`);
        return {
          price: foundPrice,
          delivery_time: '15 min',
          in_stock: true,
          search_url: searchUrl
        };
      }

      console.log(`🔍 Instamart scraping failed for ${itemName}, showing N/A`);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    } catch (error) {
      console.error('❌ Error scraping Instamart:', error.message);
      return {
        price: 'N/A',
        delivery_time: 'N/A',
        in_stock: false,
        search_url: searchUrl
      };
    }
  }

  /**
   * Get realistic mock prices based on item type and retailer
   * @param {string} itemName - Item name
   * @param {string} retailer - Retailer name
   * @returns {Object} - Price data
   */
  getRealisticMockPrice(itemName, retailer) {
    const itemNameLower = itemName.toLowerCase();
    
    // Realistic price ranges based on actual market data
    const priceRanges = {
      'milk': { min: 45, max: 65, avg: 55 },
      'bread': { min: 30, max: 45, avg: 38 },
      'eggs': { min: 60, max: 85, avg: 72 },
      'tomatoes': { min: 35, max: 55, avg: 45 },
      'onions': { min: 25, max: 40, avg: 32 },
      'potatoes': { min: 20, max: 35, avg: 28 },
      'rice': { min: 50, max: 80, avg: 65 },
      'sugar': { min: 40, max: 60, avg: 50 },
      'salt': { min: 15, max: 25, avg: 20 },
      'oil': { min: 120, max: 180, avg: 150 },
      'butter': { min: 80, max: 120, avg: 100 },
      'cheese': { min: 150, max: 250, avg: 200 },
      'yogurt': { min: 40, max: 60, avg: 50 }
    };

    // Find matching item
    let priceRange = priceRanges['milk']; // default
    for (const [item, range] of Object.entries(priceRanges)) {
      if (itemNameLower.includes(item)) {
        priceRange = range;
        break;
      }
    }

    // Add retailer-specific variations
    const retailerVariations = {
      'zepto': { min: -2, max: 2 },
      'blinkit': { min: -1, max: 3 },
      'instamart': { min: -3, max: 1 }
    };

    const variation = retailerVariations[retailer] || { min: 0, max: 0 };
    const basePrice = priceRange.avg;
    const priceVariation = Math.floor(Math.random() * (variation.max - variation.min + 1)) + variation.min;
    const finalPrice = Math.max(priceRange.min, Math.min(priceRange.max, basePrice + priceVariation));

    return {
      price: finalPrice,
      delivery_time: retailer === 'zepto' ? '10 min' : retailer === 'blinkit' ? '9 min' : '15 min',
      in_stock: true,
      search_url: this.getSearchUrl(itemName, retailer)
    };
  }

  /**
   * Get search URL for retailer
   * @param {string} itemName - Item name
   * @param {string} retailer - Retailer name
   * @returns {string} - Search URL
   */
  getSearchUrl(itemName, retailer) {
    const encodedItem = encodeURIComponent(itemName);
    
    switch (retailer.toLowerCase()) {
      case 'zepto':
        return `https://www.zepto.in/search?q=${encodedItem}`;
      case 'blinkit':
        return `https://blinkit.com/s/?q=${encodedItem}`;
      case 'instamart':
        return `https://www.swiggy.com/instamart?query=${encodedItem}`;
      default:
        return `https://www.google.com/search?q=${encodedItem}+${retailer}`;
    }
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

  /**
   * Scrape product suggestions from retailer websites
   * @param {string} itemName - Base item name (e.g., "butter")
   * @param {string} retailer - Retailer name
   * @param {number} userId - User ID for authentication
   * @returns {Promise<Array>} - Array of product suggestions
   */
  async scrapeProductSuggestions(itemName, retailer, userId = null) {
    try {
      console.log(`🔍 Scraping ${retailer} suggestions for: ${itemName}`);
      
      let suggestions = [];
      
      switch (retailer.toLowerCase()) {
        case 'zepto':
          suggestions = await this.scrapeZeptoSuggestions(itemName, userId);
          break;
        case 'blinkit':
          suggestions = await this.scrapeBlinkitSuggestions(itemName, userId);
          break;
        case 'instamart':
          suggestions = await this.scrapeInstamartSuggestions(itemName, userId);
          break;
        default:
          suggestions = this.getRealisticProductSuggestions(itemName, retailer);
      }
      
      // Limit to 3 suggestions per retailer
      return suggestions.slice(0, 3);
    } catch (error) {
      console.error(`❌ Error scraping ${retailer} suggestions:`, error.message);
      return this.getRealisticProductSuggestions(itemName, retailer).slice(0, 3);
    }
  }

  /**
   * Scrape product suggestions from Zepto
   * @param {string} itemName - Item name
   * @param {number} userId - User ID for authentication
   * @returns {Promise<Array>} - Product suggestions
   */
  async scrapeZeptoSuggestions(itemName, userId = null) {
    try {
      const searchUrl = `https://www.zepto.in/search?q=${encodeURIComponent(itemName)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      const html = response.data;
      
      // Extract product information using regex patterns
      const suggestions = [];
      
      // Look for product names and prices in the HTML
      const productPatterns = [
        /"name"\s*:\s*"([^"]+)"/gi,
        /"title"\s*:\s*"([^"]+)"/gi,
        /"product_name"\s*:\s*"([^"]+)"/gi,
        /<h[1-6][^>]*>([^<]+(?:butter|milk|bread|cheese|yogurt)[^<]*)<\/h[1-6]>/gi,
        /<span[^>]*class="[^"]*product[^"]*"[^>]*>([^<]+)<\/span>/gi
      ];
      
      const pricePatterns = [
        /"price"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /"amount"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g
      ];
      
      // Extract product names
      const productNames = new Set();
      for (const pattern of productPatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const name = match[1].trim();
          if (name.toLowerCase().includes(itemName.toLowerCase()) && name.length > 3) {
            productNames.add(name);
          }
        }
      }
      
      // Extract prices
      const prices = [];
      for (const pattern of pricePatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const price = parseFloat(match[1]);
          if (price >= 10 && price <= 1000) {
            prices.push(price);
          }
        }
      }
      
      // Combine names and prices
      let nameIndex = 0;
      for (const name of productNames) {
        if (nameIndex >= 3) break; // Limit to 3 suggestions
        
        const price = prices[nameIndex] || Math.floor(Math.random() * 50) + 30; // Fallback price
        
        suggestions.push({
          name: name,
          price: price,
          retailer: 'Zepto',
          delivery_time: '10 min',
          search_url: searchUrl,
          in_stock: true
        });
        
        nameIndex++;
      }
      
      console.log(`🔍 Found ${suggestions.length} Zepto suggestions for ${itemName}`);
      return suggestions;
      
    } catch (error) {
      console.error('❌ Error scraping Zepto suggestions:', error.message);
      return this.getRealisticProductSuggestions(itemName, 'zepto');
    }
  }

  /**
   * Scrape product suggestions from Blinkit
   * @param {string} itemName - Item name
   * @returns {Promise<Array>} - Product suggestions
   */
  async scrapeBlinkitSuggestions(itemName) {
    try {
      const searchUrl = `https://blinkit.com/s/?q=${encodeURIComponent(itemName)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      const html = response.data;
      
      // Similar extraction logic as Zepto
      const suggestions = [];
      
      const productPatterns = [
        /"name"\s*:\s*"([^"]+)"/gi,
        /"title"\s*:\s*"([^"]+)"/gi,
        /"product_name"\s*:\s*"([^"]+)"/gi,
        /<h[1-6][^>]*>([^<]+(?:butter|milk|bread|cheese|yogurt)[^<]*)<\/h[1-6]>/gi,
        /<span[^>]*class="[^"]*product[^"]*"[^>]*>([^<]+)<\/span>/gi
      ];
      
      const pricePatterns = [
        /"price"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /"amount"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g
      ];
      
      const productNames = new Set();
      for (const pattern of productPatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const name = match[1].trim();
          if (name.toLowerCase().includes(itemName.toLowerCase()) && name.length > 3) {
            productNames.add(name);
          }
        }
      }
      
      const prices = [];
      for (const pattern of pricePatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const price = parseFloat(match[1]);
          if (price >= 10 && price <= 1000) {
            prices.push(price);
          }
        }
      }
      
      let nameIndex = 0;
      for (const name of productNames) {
        if (nameIndex >= 3) break;
        
        const price = prices[nameIndex] || Math.floor(Math.random() * 50) + 30;
        
        suggestions.push({
          name: name,
          price: price,
          retailer: 'Blinkit',
          delivery_time: '9 min',
          search_url: searchUrl,
          in_stock: true
        });
        
        nameIndex++;
      }
      
      console.log(`🔍 Found ${suggestions.length} Blinkit suggestions for ${itemName}`);
      return suggestions;
      
    } catch (error) {
      console.error('❌ Error scraping Blinkit suggestions:', error.message);
      return this.getRealisticProductSuggestions(itemName, 'blinkit');
    }
  }

  /**
   * Scrape product suggestions from Instamart
   * @param {string} itemName - Item name
   * @returns {Promise<Array>} - Product suggestions
   */
  async scrapeInstamartSuggestions(itemName) {
    try {
      const searchUrl = `https://www.swiggy.com/instamart?query=${encodeURIComponent(itemName)}`;
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        },
        timeout: 15000,
        maxRedirects: 5
      });

      const html = response.data;
      
      // Similar extraction logic
      const suggestions = [];
      
      const productPatterns = [
        /"name"\s*:\s*"([^"]+)"/gi,
        /"title"\s*:\s*"([^"]+)"/gi,
        /"product_name"\s*:\s*"([^"]+)"/gi,
        /<h[1-6][^>]*>([^<]+(?:butter|milk|bread|cheese|yogurt)[^<]*)<\/h[1-6]>/gi,
        /<span[^>]*class="[^"]*product[^"]*"[^>]*>([^<]+)<\/span>/gi
      ];
      
      const pricePatterns = [
        /"price"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /"amount"\s*:\s*(\d+(?:\.\d{2})?)/gi,
        /₹\s*(\d+(?:\.\d{2})?)/g,
        /Rs\.\s*(\d+(?:\.\d{2})?)/g
      ];
      
      const productNames = new Set();
      for (const pattern of productPatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const name = match[1].trim();
          if (name.toLowerCase().includes(itemName.toLowerCase()) && name.length > 3) {
            productNames.add(name);
          }
        }
      }
      
      const prices = [];
      for (const pattern of pricePatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const price = parseFloat(match[1]);
          if (price >= 10 && price <= 1000) {
            prices.push(price);
          }
        }
      }
      
      let nameIndex = 0;
      for (const name of productNames) {
        if (nameIndex >= 3) break;
        
        const price = prices[nameIndex] || Math.floor(Math.random() * 50) + 30;
        
        suggestions.push({
          name: name,
          price: price,
          retailer: 'Instamart',
          delivery_time: '15 min',
          search_url: searchUrl,
          in_stock: true
        });
        
        nameIndex++;
      }
      
      console.log(`🔍 Found ${suggestions.length} Instamart suggestions for ${itemName}`);
      return suggestions;
      
    } catch (error) {
      console.error('❌ Error scraping Instamart suggestions:', error.message);
      return this.getRealisticProductSuggestions(itemName, 'instamart');
    }
  }

  /**
   * Get realistic product suggestions when scraping fails
   * @param {string} itemName - Item name
   * @param {string} retailer - Retailer name
   * @returns {Array} - Realistic product suggestions
   */
  getRealisticProductSuggestions(itemName, retailer) {
    const suggestions = [];
    const baseName = itemName.toLowerCase();
    
    // Realistic product variants based on item type
    const productVariants = {
      'milk': [
        { name: 'Amul Full Cream Milk 1L', price: 58 },
        { name: 'Nestle Fresh Milk 1L', price: 62 },
        { name: 'Mother Dairy Toned Milk 1L', price: 54 }
      ],
      'butter': [
        { name: 'Amul Butter 100g', price: 55 },
        { name: 'Nestle Butter 100g', price: 58 },
        { name: 'Mother Dairy Butter 100g', price: 52 }
      ],
      'peanut butter': [
        { name: 'Skippy Peanut Butter 340g', price: 185 },
        { name: 'Pintola Peanut Butter 340g', price: 165 },
        { name: 'MyFitness Peanut Butter 340g', price: 195 }
      ],
      'bread': [
        { name: 'Britannia Brown Bread 400g', price: 35 },
        { name: 'Harvest Gold Wheat Bread 400g', price: 32 },
        { name: 'Modern White Bread 400g', price: 28 }
      ],
      'cheese': [
        { name: 'Amul Processed Cheese 200g', price: 95 },
        { name: 'Britannia Cheese Slices 200g', price: 88 },
        { name: 'Go Cheese Block 200g', price: 102 }
      ],
      'yogurt': [
        { name: 'Amul Masti Dahi 400g', price: 25 },
        { name: 'Nestle A+ Curd 400g', price: 28 },
        { name: 'Mother Dairy Curd 400g', price: 22 }
      ],
      'chips': [
        { name: 'Lay\'s Classic Salted 30g', price: 20 },
        { name: 'Kurkure Chilli Chatka 30g', price: 18 },
        { name: 'Pringles Original 110g', price: 95 }
      ],
      'snacks': [
        { name: 'Haldiram\'s Mixture 150g', price: 45 },
        { name: 'Bikaji Bhujia 200g', price: 35 },
        { name: 'Kurkure Chilli Chatka 30g', price: 18 }
      ]
    };
    
    // Find matching variants
    let variants = productVariants[baseName] || productVariants['milk']; // Default to milk
    
    // If exact match not found, try partial matches
    if (!productVariants[baseName]) {
      for (const [key, value] of Object.entries(productVariants)) {
        if (baseName.includes(key) || key.includes(baseName)) {
          variants = value;
          break;
        }
      }
    }
    
    // Add retailer-specific pricing variations
    const retailerMultipliers = {
      'zepto': 1.0,
      'blinkit': 1.05,
      'instamart': 1.08
    };
    
    const multiplier = retailerMultipliers[retailer.toLowerCase()] || 1.0;
    
    variants.forEach((variant, index) => {
      const adjustedPrice = Math.round(variant.price * multiplier);
      const deliveryTimes = {
        'zepto': '10 min',
        'blinkit': '9 min',
        'instamart': '15 min'
      };
      
      suggestions.push({
        name: variant.name,
        price: adjustedPrice,
        retailer: retailer.charAt(0).toUpperCase() + retailer.slice(1),
        delivery_time: deliveryTimes[retailer.toLowerCase()] || '10 min',
        search_url: `https://www.${retailer.toLowerCase()}.com/search?q=${encodeURIComponent(variant.name)}`,
        in_stock: true
      });
    });
    
    return suggestions;
  }
}

module.exports = new AIService(); 