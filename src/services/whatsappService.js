const twilio = require('twilio');

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

class WhatsAppService {
  /**
   * Send a text message via WhatsApp
   * @param {string} to - Recipient phone number (with country code)
   * @param {string} message - Message content
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendMessage(to, message) {
    try {
      console.log(`📤 Sending message to ${to}: ${message.substring(0, 50)}...`);
      
      // Clean the phone number (remove whatsapp: prefix if present)
      const cleanTo = to.replace('whatsapp:', '');
      
      const twilioMessage = await twilioClient.messages.create({
        body: message,
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${cleanTo}`
      });

      console.log(`✅ Message sent successfully. SID: ${twilioMessage.sid}`);
      return twilioMessage;
    } catch (error) {
      console.error(`❌ Failed to send message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send a message with media (image, document, etc.)
   * @param {string} to - Recipient phone number
   * @param {string} mediaUrl - URL of the media file
   * @param {string} caption - Optional caption
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendMediaMessage(to, mediaUrl, caption = '') {
    try {
      console.log(`📤 Sending media message to ${to}`);
      
      // Clean the phone number (remove whatsapp: prefix if present)
      const cleanTo = to.replace('whatsapp:', '');
      
      const twilioMessage = await twilioClient.messages.create({
        mediaUrl: [mediaUrl],
        body: caption,
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${cleanTo}`
      });

      console.log(`✅ Media message sent successfully. SID: ${twilioMessage.sid}`);
      return twilioMessage;
    } catch (error) {
      console.error(`❌ Failed to send media message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send a template message (for outside 24-hour window)
   * @param {string} to - Recipient phone number
   * @param {string} templateName - Template name
   * @param {Object} variables - Template variables
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendTemplateMessage(to, templateName, variables = {}) {
    try {
      console.log(`📤 Sending template message to ${to}: ${templateName}`);
      
      // Clean the phone number (remove whatsapp: prefix if present)
      const cleanTo = to.replace('whatsapp:', '');
      
      const twilioMessage = await twilioClient.messages.create({
        body: this.formatTemplate(templateName, variables),
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:${cleanTo}`
      });

      console.log(`✅ Template message sent successfully. SID: ${twilioMessage.sid}`);
      return twilioMessage;
    } catch (error) {
      console.error(`❌ Failed to send template message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Format template message with variables
   * @param {string} templateName - Template name
   * @param {Object} variables - Variables to substitute
   * @returns {string} - Formatted message
   */
  formatTemplate(templateName, variables) {
    const templates = {
      'welcome': '👋 Welcome to ShopGenie AI! 🛒\n\nI can help you compare prices across grocery platforms.\n\nTry saying: "Order milk and bread to 123 Main St, Bangalore"',
      'order_reminder': '🛒 Ready to order? Send me your grocery list and I\'ll find the best prices!',
      'address_required': '📍 Please provide your delivery address first.\n\nExample: "My address is 123 Main St, Bangalore 560001"',
      'error': '😔 Sorry, I encountered an error. Please try again or type "help" for assistance.',
      'unauthorized': '❌ This bot is currently in private beta. Please wait for public release.'
    };

    let message = templates[templateName] || templates['error'];
    
    // Replace variables in the message
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      message = message.replace(regex, variables[key]);
    });

    return message;
  }

  /**
   * Send a structured message with buttons (simulated with text)
   * @param {string} to - Recipient phone number
   * @param {string} title - Message title
   * @param {string} body - Message body
   * @param {Array} buttons - Array of button objects
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendButtonMessage(to, title, body, buttons) {
    try {
      let message = `*${title}*\n\n${body}\n\n`;
      
      buttons.forEach((button, index) => {
        message += `${index + 1}. ${button.text}\n`;
      });

      return await this.sendMessage(to, message);
    } catch (error) {
      console.error(`❌ Failed to send button message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send a list message (simulated with text)
   * @param {string} to - Recipient phone number
   * @param {string} title - List title
   * @param {Array} items - Array of list items
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendListMessage(to, title, items) {
    try {
      let message = `*${title}*\n\n`;
      
      items.forEach((item, index) => {
        message += `${index + 1}. ${item.title}`;
        if (item.description) {
          message += ` - ${item.description}`;
        }
        message += '\n';
      });

      return await this.sendMessage(to, message);
    } catch (error) {
      console.error(`❌ Failed to send list message to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send a price comparison message
   * @param {string} to - Recipient phone number
   * @param {Array} comparisons - Array of price comparisons
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendPriceComparison(to, comparisons) {
    try {
      let message = "🛒 *Price Comparison:*\n\n";
      
      comparisons.forEach(item => {
        message += `*${item.name}*\n`;
        item.prices.forEach(price => {
          message += `• ${price.retailer}: ₹${price.price}\n`;
        });
        message += "\n";
      });

      message += "Reply with the retailer name to select your preference.";

      return await this.sendMessage(to, message);
    } catch (error) {
      console.error(`❌ Failed to send price comparison to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send a cart summary message
   * @param {string} to - Recipient phone number
   * @param {Object} cart - Cart object with items and totals
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendCartSummary(to, cart) {
    try {
      let message = "🛒 *Your Cart Summary:*\n\n";
      
      cart.items.forEach(item => {
        message += `• ${item.name} (${item.quantity} ${item.unit}): ₹${item.price}\n`;
      });

      message += `\n*Total: ₹${cart.total}*\n\n`;
      message += "Reply 'confirm' to proceed with checkout.";

      return await this.sendMessage(to, message);
    } catch (error) {
      console.error(`❌ Failed to send cart summary to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Send deep links for checkout
   * @param {string} to - Recipient phone number
   * @param {Object} deepLinks - Object with retailer names and URLs
   * @returns {Promise<Object>} - Twilio message object
   */
  async sendDeepLinks(to, deepLinks) {
    try {
      let message = "🔗 *Checkout Links:*\n\n";
      
      Object.entries(deepLinks).forEach(([retailer, url]) => {
        message += `🛒 ${retailer}: ${url}\n`;
      });

      message += "\nClick the links above to complete your order.";

      return await this.sendMessage(to, message);
    } catch (error) {
      console.error(`❌ Failed to send deep links to ${to}:`, error);
      throw error;
    }
  }

  /**
   * Validate phone number format
   * @param {string} phoneNumber - Phone number to validate
   * @returns {boolean} - Whether the phone number is valid
   */
  validatePhoneNumber(phoneNumber) {
    // Basic validation for international phone numbers
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phoneNumber);
  }

  /**
   * Format phone number for WhatsApp
   * @param {string} phoneNumber - Raw phone number
   * @returns {string} - Formatted phone number
   */
  formatPhoneNumber(phoneNumber) {
    // Remove any non-digit characters except +
    let cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // Ensure it starts with +
    if (!cleaned.startsWith('+')) {
      cleaned = '+' + cleaned;
    }
    
    return cleaned;
  }
}

module.exports = new WhatsAppService(); 