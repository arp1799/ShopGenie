const express = require('express');
const router = express.Router();
const twilio = require('twilio');

// Import services
const whatsappService = require('../services/whatsappService');
const aiService = require('../services/aiService');
const userService = require('../services/userService');
const cartService = require('../services/cartService');

// Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Webhook verification for Twilio (simplified for sandbox)
router.get('/', (req, res) => {
  // For Twilio sandbox, we don't need complex verification
  res.status(200).send('WhatsApp webhook is ready');
});

// Main webhook endpoint for incoming messages
router.post('/', async (req, res) => {
  try {
    // Verify the request is from Twilio
    const signature = req.headers['x-twilio-signature'];
    const url = `${process.env.APP_BASE_URL}/webhook`;
    const params = req.body;
    
    const isValid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      url,
      params
    );

    if (!isValid) {
      console.log('❌ Invalid Twilio signature');
      return res.status(403).send('Forbidden');
    }

    // Extract message details
    const message = req.body.Body;
    const from = req.body.From; // WhatsApp number
    const messageSid = req.body.MessageSid;
    const messageType = req.body.MediaContentType0 || 'text'; // Check if it's a location or text

    console.log(`📱 Received message from ${from}: ${message} (Type: ${messageType})`);

    // Check if user is allowed (for Phase 1)
    const allowedRecipients = process.env.ALLOWED_RECIPIENTS.split(',');
    const cleanFrom = from.replace('whatsapp:', ''); // Remove whatsapp: prefix
    
    if (!allowedRecipients.includes(cleanFrom)) {
      console.log(`❌ Unauthorized user: ${cleanFrom}`);
      await whatsappService.sendMessage(
        from,
        "❌ This bot is currently in private beta. Please wait for public release."
      );
      return res.status(200).send('OK');
    }

    // Process the message
    await processMessage(from, message, messageSid, messageType);

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Process incoming message
async function processMessage(from, message, messageSid, messageType) {
  try {
    // Clean the phone number (remove whatsapp: prefix)
    const cleanFrom = from.replace('whatsapp:', '');
    
    // Get or create user
    let user = await userService.getUserByPhone(cleanFrom);
    if (!user) {
      user = await userService.createUser(cleanFrom);
      await whatsappService.sendMessage(
        from,
        "👋 Welcome to ShopGenie AI! 🛒\n\nI can help you compare prices across grocery platforms and build your cart.\n\nTry saying: 'Order milk and bread to 123 Main St, Bangalore'"
      );
      return;
    }

    // Log the message
    await userService.logMessage(user.id, 'inbound', message, { messageSid });

    // STEP 1: Handle location messages (highest priority)
    if (messageType === 'application/vnd.geo+json' || messageType === 'location') {
      await handleLocationMessage(from, user, message, messageSid);
      return;
    }

    // STEP 2: Get user session for flow management
    const userSession = await userService.getUserSession(user.id);
    console.log(`🔍 [SESSION] User ${user.id} session:`, userSession);

    // STEP 3: Handle direct pattern matches (bypasses everything else)
    const lowerMessage = message.toLowerCase().trim();
    
    // Emergency commands (always work)
    if (lowerMessage === 'clear session' || lowerMessage === 'reset') {
      console.log('🧹 [SESSION] Direct pattern match: clear session command');
      
      // Clear session data
      await userService.updateUserSession(user.id, {});
      
      // Clear retailer credentials (optional - uncomment if you want to clear auth too)
      // const authService = require('../services/authService');
      // await authService.deleteAllRetailerCredentials(user.id);
      
      await whatsappService.sendMessage(from, "🔄 Session cleared! You can start fresh now.");
      return;
    }
    
    // Clear all data (session + auth + cart)
    if (lowerMessage === 'clear all' || lowerMessage === 'reset all') {
      console.log('🧹 [SESSION] Direct pattern match: clear all command');
      
      // Clear session data
      await userService.updateUserSession(user.id, {});
      
      // Clear retailer credentials
      const authService = require('../services/authService');
      await authService.deleteAllRetailerCredentials(user.id);
      
      // Clear cart
      const cart = await cartService.getActiveCart(user.id);
      if (cart) {
        await cartService.clearCart(cart.id);
      }
      
      await whatsappService.sendMessage(from, "🔄 All data cleared! Session, authentication, and cart reset.");
      return;
    }

    // Simple commands (no AI needed)
    if (lowerMessage === 'help' || lowerMessage === 'start') {
      await sendHelpMessage(from);
      return;
    }

    if (lowerMessage === 'stop' || lowerMessage === 'unsubscribe') {
      await userService.updateUserAllowed(user.id, false);
      await whatsappService.sendMessage(from, "👋 You've been unsubscribed from ShopGenie AI. Send 'start' to re-enable.");
      return;
    }

    if (lowerMessage === 'show cart' || lowerMessage === 'view cart') {
      await handleShowCartIntent(from, user);
      return;
    }

    if (lowerMessage === 'show prices' || lowerMessage === 'prices') {
      await handleShowPricesIntent(from, user);
      return;
    }

    if (lowerMessage === 'checkout') {
      await handleCheckoutIntent(from, user);
      return;
    }

    if (lowerMessage === 'connected retailers' || lowerMessage === 'show connected' || lowerMessage === 'my retailers' || 
        lowerMessage === 'my loginned apps' || lowerMessage === 'my logged in apps' || lowerMessage === 'logged in apps') {
      await handleShowConnectedRetailers(from, user);
      return;
    }

    // Authentication commands
    if (lowerMessage.startsWith('login ')) {
      const retailer = lowerMessage.replace('login ', '').trim();
      await handleAuthenticationIntent(from, user, { intent: 'authentication', retailer });
      return;
    }

    // Login method selection
    if (lowerMessage === 'phone' || lowerMessage === '1') {
      await handlePhoneLoginMethod(from, user);
      return;
    }

    if (lowerMessage === 'email' || lowerMessage === '2') {
      await handleEmailLoginMethod(from, user);
      return;
    }

    // Resend OTP command
    if (lowerMessage === 'resend otp' || lowerMessage === 'resend') {
      await handleResendOTP(from, user);
      return;
    }

    // Product selection commands (e.g., "1 for milk", "2 for bread")
    const productSelectionPattern = /^(\d+)\s+for\s+(.+)$/i;
    const productSelectionMatch = lowerMessage.match(productSelectionPattern);
    if (productSelectionMatch) {
      const selectionNumber = parseInt(productSelectionMatch[1]);
      const itemName = productSelectionMatch[2].trim();
      await handleProductSelection(from, user, { 
        intent: 'product_selection', 
        selectionNumber, 
        itemName 
      });
      return;
    }

    // All selection commands (e.g., "all 1", "all 2")
    const allSelectionPattern = /^all\s+(\d+)$/i;
    const allSelectionMatch = lowerMessage.match(allSelectionPattern);
    if (allSelectionMatch) {
      const selectionNumber = parseInt(allSelectionMatch[1]);
      await handleProductSelection(from, user, { 
        intent: 'product_selection', 
        selectionNumber, 
        itemName: 'all',
        selectAll: true
      });
      return;
    }

    // Checkout flow commands
    if (lowerMessage === 'cancel checkout' || lowerMessage === 'cancel order') {
      await userService.updateUserSession(user.id, {});
      await whatsappService.sendMessage(from, "❌ Checkout cancelled. You can start over anytime.");
      return;
    }

    if (lowerMessage === 'confirm order') {
      await handleConfirmOrder(from, user);
      return;
    }

    if (lowerMessage === 'edit cart') {
      await handleEditCart(from, user);
      return;
    }

    // Retailer selection for checkout (e.g., "zepto for milk", "blinkit for bread")
    const retailerSelectionPattern = /^(\w+)\s+for\s+(.+)$/i;
    const retailerSelectionMatch = lowerMessage.match(retailerSelectionPattern);
    if (retailerSelectionMatch) {
      const retailer = retailerSelectionMatch[1].toLowerCase();
      const itemName = retailerSelectionMatch[2].trim();
      await handleRetailerSelectionForCheckout(from, user, retailer, itemName);
      return;
    }

    // Skip item command (e.g., "skip milk", "skip bread")
    const skipPattern = /^skip\s+(.+)$/i;
    const skipMatch = lowerMessage.match(skipPattern);
    if (skipMatch) {
      const itemName = skipMatch[1].trim();
      await handleSkipItem(from, user, itemName);
      return;
    }

    // Order mode commands
    if (lowerMessage === 'add selected') {
      await handleAddSelectedToCart(from, user);
      return;
    }

    if (lowerMessage === 'cancel order') {
      await userService.updateUserSession(user.id, {});
      await whatsappService.sendMessage(from, "❌ Order cancelled. You can start over anytime.");
      return;
    }

    // STEP 4: Handle authentication flow (if active)
    if (userSession.auth_flow) {
      console.log(`🔐 [AUTH_FLOW] Processing ${userSession.auth_flow} flow for user ${user.id}`);
      
      if (userSession.auth_flow === 'phone_login') {
        if (userSession.auth_step === 'phone_input') {
          await handlePhoneNumberInput(from, user, message);
          return;
        } else if (userSession.auth_step === 'otp_input') {
          await handleOTPInput(from, user, message);
          return;
        }
      } else if (userSession.auth_flow === 'email_login') {
        if (userSession.auth_step === 'email_input') {
          await handleEmailInput(from, user, message);
          return;
        } else if (userSession.auth_step === 'password_input') {
          await handlePasswordInput(from, user, message);
          return;
        }
      }
    }

    // STEP 5: Clear stale session data
    if (userSession.auth_flow && !userSession.auth_step) {
      console.log(`🧹 [SESSION] Clearing stale session data for user ${user.id}`);
      await userService.updateUserSession(user.id, {});
    }

    // STEP 6: AI PARSING (only for complex commands)
    console.log(`🤖 [AI] Using AI parsing for complex command: "${message}"`);
    const parsedIntent = await aiService.parseMessage(message);
    
    // Handle AI parsed intents
    switch (parsedIntent.intent) {
      case 'order':
        await handleOrderIntent(from, user, parsedIntent);
        break;
      case 'add_item':
        await handleAddItemIntent(from, user, parsedIntent);
        break;
      case 'remove_item':
        await handleRemoveItemIntent(from, user, parsedIntent);
        break;
      case 'show_prices':
        await handleShowPricesIntent(from, user);
        break;
      case 'show_cart':
        await handleShowCartIntent(from, user);
        break;
      case 'address_confirmation':
        await handleAddressConfirmation(from, user, parsedIntent);
        break;
      case 'authentication':
        await handleAuthenticationIntent(from, user, parsedIntent);
        break;
      case 'credential_input':
        await handleCredentialInput(from, user, parsedIntent);
        break;
      case 'product_selection':
        await handleProductSelection(from, user, parsedIntent);
        break;
      case 'retailer_selection':
        await handleRetailerSelection(from, user, parsedIntent);
        break;
      default:
        await whatsappService.sendMessage(
          from,
          "🤔 I didn't understand that. Try saying:\n\n'Order milk and bread to 123 Main St, Bangalore'\n\nOr type 'help' for more options."
        );
    }

  } catch (error) {
    console.error('❌ Error processing message:', error);
    
    // Check if it's an authentication-related error (schema issue)
    if (error.message && (
      error.message.includes('login_id') || 
      error.message.includes('login_type') ||
      error.message.includes('retailer_credentials')
    )) {
      console.log('🔐 [ERROR] Authentication table schema issue detected, redirecting to setup');
      await whatsappService.sendMessage(
        from,
        "🔐 *Welcome to ShopGenie AI!*\n\n" +
        "I need to set up your account first. Please connect your retailer accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me get the best prices and availability for you!"
      );
    } else {
      await whatsappService.sendMessage(
        from,
        "😔 Sorry, I encountered an error. Please try again or type 'help' for assistance."
      );
    }
  }
}

// Handle order intent
async function handleOrderIntent(from, user, parsedIntent) {
  try {
    console.log(`🛒 [ORDER] Processing order intent for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    console.log(`🔐 [ORDER] User has ${userCredentials.length} authenticated retailers: ${userCredentials.map(c => c.retailer).join(', ')}`);
    
    // If order has address in it, handle that first
    if (parsedIntent.address) {
      const validatedAddress = await aiService.validateAddress(parsedIntent.address);
      if (validatedAddress) {
        await userService.saveAddress(user.id, validatedAddress);
        await sendAddressConfirmation(from, validatedAddress);
        return;
      }
    }

    // Check if user has any address (including unconfirmed)
    const userAddress = await userService.getUserPrimaryAddressIncludingUnconfirmed(user.id);
    
    // If no address at all, ask for one
    if (!userAddress) {
      await whatsappService.sendMessage(
        from,
        "📍 Please provide your delivery address first.\n\nYou can:\n• Type your address directly\n• Share your location 📍\n• Say 'My address is 123 Main St, Bangalore 560001'"
      );
      return;
    }

    // If address exists but not confirmed, ask for confirmation
    if (userAddress && !userAddress.confirmed) {
      await sendAddressConfirmation(from, userAddress);
      return;
    }

    // Create or get active cart
    let cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      cart = await cartService.createCart(user.id);
    }

    // Store items in session for selection (don't add to cart yet)
    await userService.updateUserSession(user.id, {
      order_mode: true,
      order_items: parsedIntent.items,
      order_cart_id: cart.id
    });

    // Show product suggestions for selection
    await showOrderSuggestions(from, user, parsedIntent.items);

  } catch (error) {
    console.error('❌ Error handling order intent:', error);
    throw error;
  }
}

// Handle add item intent
async function handleAddItemIntent(from, user, parsedIntent) {
  try {
    console.log(`🛒 [ADD_ITEM] Processing add item intent for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    console.log(`🔐 [ADD_ITEM] User has ${userCredentials.length} authenticated retailers: ${userCredentials.map(c => c.retailer).join(', ')}`);
    
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart. Start by saying 'Order [items]'"
      );
      return;
    }

    const addedItems = [];
    for (const item of parsedIntent.items) {
      await cartService.addItemToCart(cart.id, item);
      addedItems.push(`${item.quantity} ${item.unit} ${item.name}`);
    }

    await whatsappService.sendMessage(
      from,
      `✅ Added to your cart:\n${addedItems.map(item => `• ${item}`).join('\n')}\n\nType 'show cart' to see your current items.`
    );

    // Show product suggestions for the newly added items
    const productSuggestions = await cartService.getProductSuggestions(cart.id, user.id);
    await sendProductSuggestions(from, productSuggestions, user);

  } catch (error) {
    console.error('❌ [ADD_ITEM] Error handling add item intent:', error);
    throw error;
  }
}

// Handle remove item intent
async function handleRemoveItemIntent(from, user, parsedIntent) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart."
      );
      return;
    }

    // Implementation for removing items
    await whatsappService.sendMessage(
      from,
      "🔄 Item removal feature coming soon!"
    );

  } catch (error) {
    console.error('❌ Error handling remove item intent:', error);
    throw error;
  }
}

// Handle address confirmation
async function handleAddressConfirmation(from, user, parsedIntent) {
  try {
    if (parsedIntent.confirmed) {
      await userService.confirmAddress(user.id);
      await whatsappService.sendMessage(
        from,
        "✅ Address confirmed! Now you can start ordering.\n\nTry: 'Order milk and bread'"
      );
    } else {
      await whatsappService.sendMessage(
        from,
        "📍 Please provide your correct address.\n\nExample: 'My address is 123 Main St, Bangalore 560001'"
      );
    }
  } catch (error) {
    console.error('❌ Error handling address confirmation:', error);
    throw error;
  }
}

// Handle retailer selection
async function handleRetailerSelection(from, user, parsedIntent) {
  try {
    console.log(`🏪 [RETAILER_SELECTION] Processing retailer selection for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    console.log(`🔐 [RETAILER_SELECTION] User has ${userCredentials.length} authenticated retailers: ${userCredentials.map(c => c.retailer).join(', ')}`);
    
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart."
      );
      return;
    }

    // Update cart with retailer choices
    await cartService.updateRetailerChoices(cart.id, parsedIntent.choices);
    
    // Generate final cart summary
    const finalCart = await cartService.generateFinalCart(cart.id);
    await sendFinalCartSummary(from, finalCart);

  } catch (error) {
    console.error('❌ Error handling retailer selection:', error);
    throw error;
  }
}

// Send help message
async function sendHelpMessage(from) {
  const helpText = `🛒 *ShopGenie AI Help*

*How to use:*
1. 📍 Set your address:
   • Type: "My address is 123 Main St, Bangalore"
   • Type directly: "B-102, HSR Layout, Bangalore 560102"
   • Share location: 📍 (Use WhatsApp location feature)
2. 🛒 Order items: "Order milk and bread"
3. 🏪 Choose retailers: Select from the options provided
4. 🔗 Get cart links: Click the links to complete your order

*Commands:*
• help - Show this message
• stop - Unsubscribe from the service
• show cart - View current cart items

*Supported platforms:*
• Zepto
• Blinkit  
• Swiggy Instamart

*Examples:*
• "Order 2L Amul milk and 1 loaf bread to 123 Main St, Bangalore 560001"
• "B-102, Manar Elegance, HSR Layout, Bangalore 560102"
• Share your location 📍

Need help? Just type your question!`;

  await whatsappService.sendMessage(from, helpText);
}

// Send address confirmation
async function sendAddressConfirmation(from, address) {
  const message = `📍 *Confirm your delivery address:*

${address.formatted}

Is this correct?
Reply with:
✅ Yes
❌ No`;

  await whatsappService.sendMessage(from, message);
}

// Send product suggestions
async function sendProductSuggestions(from, suggestions, user) {
  let message = "🛒 *Product Suggestions:*\n\n";
  
  for (const [itemName, retailers] of Object.entries(suggestions)) {
    message += `*${itemName}*\n`;
    
    // Get mixed suggestions from all retailers for this item
    const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
    
    if (mixedSuggestions.length > 0) {
      message += "\n*Best Options (All Retailers):*\n";
      
      mixedSuggestions.forEach((product, index) => {
        const priceDisplay = product.price === 'N/A' ? 'N/A' : `₹${product.price}`;
        const deliveryDisplay = product.delivery_time === 'N/A' ? 'N/A' : product.delivery_time;
        const stockStatus = product.in_stock ? '✅' : '❌ Out of Stock';
        message += `${index + 1}. ${product.name} - ${priceDisplay} (${deliveryDisplay}) ${stockStatus}\n`;
        message += `   📍 ${product.retailer}\n`;
      });
    } else {
      // Fallback to retailer-specific suggestions
      for (const [retailer, products] of Object.entries(retailers)) {
        if (products.length > 0) {
          message += `\n*${retailer.charAt(0).toUpperCase() + retailer.slice(1)}:*\n`;
          
          products.forEach((product, index) => {
            const priceDisplay = product.price === 'N/A' ? 'N/A' : `₹${product.price}`;
            const deliveryDisplay = product.delivery_time === 'N/A' ? 'N/A' : product.delivery_time;
            const stockStatus = product.in_stock ? '✅' : '❌ Out of Stock';
            message += `${index + 1}. ${product.name} - ${priceDisplay} (${deliveryDisplay}) ${stockStatus}\n`;
          });
        }
      }
    }
    
    message += "\n";
  }

  message += "To select products, reply with:\n";
  message += "• '1 for chips' - Select 1st option for chips\n";
  message += "• '2 for milk' - Select 2nd option for milk\n";
  message += "• 'All 1' - Select 1st option for all items\n";
  message += "• 'Show cart' - View your current cart\n";
  message += "• 'Checkout' - Complete your order";

  await whatsappService.sendMessage(from, message);
}

// Send price comparison
async function sendPriceComparison(from, comparisons) {
  let message = "🛒 *Price Comparison:*\n\n";
  
  // Remove duplicates by item name
  const uniqueItems = [];
  const seenItems = new Set();
  
  for (const item of comparisons) {
    const itemName = item.name || item.product_name || 'Unknown Item';
    if (!seenItems.has(itemName.toLowerCase())) {
      seenItems.add(itemName.toLowerCase());
      uniqueItems.push(item);
    }
  }
  
  for (const item of uniqueItems) {
    const itemName = item.name || item.product_name || 'Unknown Item';
    message += `*${itemName}*\n`;
    for (const price of item.prices) {
      const priceDisplay = price.price === 'N/A' ? 'N/A' : `₹${price.price}`;
      const deliveryDisplay = price.delivery_time === 'N/A' ? 'N/A' : price.delivery_time;
      message += `• ${price.retailer}: ${priceDisplay} (${deliveryDisplay})\n`;
    }
    message += "\n";
  }

  message += "To select a retailer, reply with:\n";
  message += "• 'Zepto for milk' - Select Zepto for milk\n";
  message += "• 'Blinkit for bread' - Select Blinkit for bread\n";
  message += "• 'All Zepto' - Select Zepto for all items\n";
  message += "• 'Checkout' - Complete your order";

  await whatsappService.sendMessage(from, message);
}

// Send final cart summary
async function sendFinalCartSummary(from, finalCart) {
  let message = "✅ *Your Final Cart:*\n\n";
  
  for (const [retailer, items] of Object.entries(finalCart.retailerCarts)) {
    message += `*${retailer}:*\n`;
    for (const item of items) {
      message += `• ${item.name}: ₹${item.price}\n`;
    }
    message += `Total: ₹${finalCart.retailerTotals[retailer]}\n\n`;
  }

  message += `*Grand Total: ₹${finalCart.grandTotal}*\n\n`;
  message += "Click the links below to complete your order:";

  await whatsappService.sendMessage(from, message);
  
  // Send deep links for each retailer
  for (const [retailer, link] of Object.entries(finalCart.deepLinks)) {
    await whatsappService.sendMessage(
      from,
      `🛒 ${retailer}: ${link}`
    );
  }
}

// Handle authentication intent
async function handleAuthenticationIntent(from, user, parsedIntent) {
  try {
    console.log(`🔐 [AUTH] Handling authentication intent for user ${user.id}`);
    
    const authService = require('../services/authService');
    const { getSupportedRetailers, getRetailerByName } = require('../config/retailers');
    const retailer = parsedIntent.retailer;
    
    if (!retailer) {
      const supportedRetailers = getSupportedRetailers();
      const retailerList = supportedRetailers.map(r => `• 'Login ${r.displayName}' - ${r.description}`).join('\n');
      
      await whatsappService.sendMessage(
        from,
        `🔐 *Available Retailers:*\n\n${retailerList}\n\n` +
        "Choose a retailer to connect your account!"
      );
      return;
    }

    // Check if retailer is supported
    const retailerConfig = getRetailerByName(retailer);
    if (!retailerConfig) {
      await whatsappService.sendMessage(
        from,
        `❌ ${retailer.charAt(0).toUpperCase() + retailer.slice(1)} is not currently supported.\n\n` +
        "Supported retailers: Zepto, Blinkit, Swiggy Instamart"
      );
      return;
    }

    // Check if user already has credentials for this retailer
    const hasCredentials = await authService.hasRetailerCredentials(user.id, retailer);
    
    if (hasCredentials) {
      await whatsappService.sendMessage(
        from,
        `✅ You're already connected to ${retailerConfig.displayName}!\n\n` +
        "To update credentials, send:\n" +
        `'Update ${retailer} login_id password'`
      );
      return;
    }

    // Store retailer in session for the authentication flow
    await userService.updateUserSession(user.id, { retailer });
    
    // Start authentication flow with login method selection
    await whatsappService.sendMessage(
      from,
      `🔐 *Connect to ${retailerConfig.displayName}*\n\n` +
      "Choose your login method:\n\n" +
      "1️⃣ *Phone + OTP*\n" +
      "   Send: 'phone'\n\n" +
      "2️⃣ *Email + Password*\n" +
      "   Send: 'email'\n\n" +
      "Which method would you prefer?"
    );

  } catch (error) {
    console.error('❌ [AUTH] Error handling authentication intent:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle credential input
async function handleCredentialInput(from, user, parsedIntent) {
  try {
    console.log(`🔐 [CREDENTIALS] Processing credential input for user ${user.id}`);
    
    const authService = require('../services/authService');
    const { getRetailerByName } = require('../config/retailers');
    
    const { retailer, login_id, password } = parsedIntent;
    
    // Validate retailer
    const retailerConfig = getRetailerByName(retailer);
    if (!retailerConfig) {
      await whatsappService.sendMessage(
        from,
        `❌ ${retailer.charAt(0).toUpperCase() + retailer.slice(1)} is not supported.`
      );
      return;
    }
    
    // Determine login type (email or phone)
    const isEmail = login_id.includes('@');
    const isPhone = /^\+?[\d\s\-\(\)]+$/.test(login_id);
    const loginType = isEmail ? 'email' : (isPhone ? 'phone' : 'email');
    
    console.log(`🔐 [CREDENTIALS] Saving ${retailer} credentials (${loginType}: ${login_id})`);
    
    // Test login credentials first
    const loginTest = await authService.testRetailerLogin(retailer, login_id, password);
    
    if (!loginTest.success) {
      await whatsappService.sendMessage(
        from,
        `❌ Login failed for ${retailerConfig.displayName}:\n${loginTest.message}\n\n` +
        "Please check your credentials and try again."
      );
      return;
    }
    
    // Save credentials
    await authService.saveRetailerCredentials(user.id, retailer, login_id, password, loginType);
    
    await whatsappService.sendMessage(
      from,
      `✅ Successfully connected to ${retailerConfig.displayName}!\n\n` +
      `Login ID: ${login_id}\n` +
      `Type: ${loginType}\n\n` +
      "You can now order items and I'll use your authenticated account for better prices and availability."
    );
    
  } catch (error) {
    console.error('❌ [CREDENTIALS] Error handling credential input:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error saving your credentials. Please try again.");
  }
}

// Handle product selection
async function handleProductSelection(from, user, parsedIntent) {
  try {
    console.log(`🛒 [PRODUCT_SELECTION] Processing product selection for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    console.log(`🔐 [PRODUCT_SELECTION] User has ${userCredentials.length} authenticated retailers: ${userCredentials.map(c => c.retailer).join(', ')}`);
    
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(from, "🛒 Your cart is empty. Start by saying 'Order [items]'");
      return;
    }

    // Get current product suggestions
    const productSuggestions = await cartService.getProductSuggestions(cart.id, user.id);
    
    // Process user selections
    for (const [itemName, choice] of Object.entries(parsedIntent.choices)) {
      const productNumber = choice.productNumber;
      const specifiedRetailer = choice.retailer;
      
             // Get mixed suggestions for this item
       const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
      const selectedProduct = mixedSuggestions[productNumber - 1]; // Convert to 0-based index
      
      if (selectedProduct) {
        // If specific retailer was mentioned, verify it matches
        if (specifiedRetailer && selectedProduct.retailer !== specifiedRetailer) {
          // Find the specified retailer's product at that number
          const retailerSuggestions = await cartService.getProductSuggestions(cart.id);
          if (retailerSuggestions[itemName] && retailerSuggestions[itemName][specifiedRetailer.toLowerCase()]) {
            const retailerProducts = retailerSuggestions[itemName][specifiedRetailer.toLowerCase()];
            const retailerProduct = retailerProducts[productNumber - 1];
            if (retailerProduct) {
              await cartService.updateCartItemWithProduct(cart.id, itemName, retailerProduct);
              await whatsappService.sendMessage(
                from,
                `✅ Selected: ${retailerProduct.name} (${specifiedRetailer}) - ₹${retailerProduct.price}`
              );
            }
          }
        } else {
          // Update cart item with selected product details
          await cartService.updateCartItemWithProduct(cart.id, itemName, selectedProduct);
          
          await whatsappService.sendMessage(
            from,
            `✅ Selected: ${selectedProduct.name} (${selectedProduct.retailer}) - ₹${selectedProduct.price}`
          );
        }
      } else {
        await whatsappService.sendMessage(
          from,
          `❌ Product ${productNumber} not found for ${itemName}`
        );
      }
    }
    
    // Show updated cart
    await handleShowCartIntent(from, user);
    
  } catch (error) {
    console.error('❌ Error handling product selection:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle show prices intent
async function handleShowPricesIntent(from, user) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    const priceComparisons = await cartService.getPriceComparisons(cart.id);
    if (priceComparisons.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    // Send price comparison message
    await sendPriceComparison(from, priceComparisons);

  } catch (error) {
    console.error('❌ Error handling show prices intent:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error showing prices. Please try again."
    );
  }
}

// Handle show connected retailers
async function handleShowConnectedRetailers(from, user) {
  try {
    console.log(`🔐 [RETAILERS] Showing connected retailers for user ${user.id}`);
    
    const authService = require('../services/authService');
    const { getRetailerByName } = require('../config/retailers');
    
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Connected Retailers:*\n\n" +
        "You haven't connected any retailer accounts yet.\n\n" +
        "To connect accounts, say:\n" +
        "• 'Login Zepto'\n" +
        "• 'Login Blinkit'\n" +
        "• 'Login Instamart'\n\n" +
        "This will help me get better prices and availability for you!"
      );
      return;
    }
    
    let message = "🔐 *Your Connected Retailers:*\n\n";
    
    for (const credential of userCredentials) {
      const retailerConfig = getRetailerByName(credential.retailer);
      const displayName = retailerConfig ? retailerConfig.displayName : credential.retailer;
      const loginId = credential.login_id;
      const loginType = credential.login_type;
      const connectedDate = new Date(credential.created_at).toLocaleDateString();
      
      message += `✅ *${displayName}*\n`;
      message += `   ${loginType}: ${loginId}\n`;
      message += `   Connected: ${connectedDate}\n\n`;
    }
    
    message += "To disconnect a retailer, say:\n";
    message += "'Disconnect [retailer name]'";
    
    await whatsappService.sendMessage(from, message);
    
  } catch (error) {
    console.error('❌ [RETAILERS] Error showing connected retailers:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle show prices intent
async function handleShowPricesIntent(from, user) {
  try {
    console.log(`💰 [SHOW_PRICES] Processing show prices intent for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    console.log(`🔐 [SHOW_PRICES] User has ${userCredentials.length} authenticated retailers: ${userCredentials.map(c => c.retailer).join(', ')}`);
    
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 You don't have an active cart. Start by saying 'Order [items]'"
      );
      return;
    }

    const priceComparisons = await cartService.getPriceComparisons(cart.id);
    await sendPriceComparison(from, priceComparisons);

  } catch (error) {
    console.error('❌ [SHOW_PRICES] Error handling show prices intent:', error);
    throw error;
  }
}

// Handle checkout intent
async function handleCheckoutIntent(from, user) {
  try {
    console.log(`🛒 [CHECKOUT] Processing checkout intent for user ${user.id}`);
    
    // Check if user has authenticated retailers
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    
    if (userCredentials.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🔐 *Please connect your retailer accounts first!*\n\n" +
        "To get the best prices and availability, connect your accounts:\n\n" +
        "• 'Login Zepto' - Connect Zepto account\n" +
        "• 'Login Blinkit' - Connect Blinkit account\n" +
        "• 'Login Instamart' - Connect Swiggy Instamart account\n\n" +
        "This will help me access your personalized pricing and delivery options."
      );
      return;
    }
    
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    const cartItems = await cartService.getCartItemsCombined(cart.id);
    if (cartItems.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    // Set checkout mode in session
    await userService.updateUserSession(user.id, {
      checkout_mode: true,
      checkout_step: 'item_selection',
      checkout_items: cartItems.map(item => item.product_name),
      checkout_current_item: 0
    });

    // Show first item for selection
    await showNextCheckoutItem(from, user, cartItems, 0);

  } catch (error) {
    console.error('❌ [CHECKOUT] Error handling checkout intent:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error. Please try again."
    );
  }
}

// Show next item in checkout process
async function showNextCheckoutItem(from, user, cartItems, currentIndex) {
  try {
    if (currentIndex >= cartItems.length) {
      // All items processed, show final cart
      await showFinalCheckoutCart(from, user);
      return;
    }

    const currentItem = cartItems[currentIndex];
    const itemName = currentItem.product_name;
    
    // Get price comparison for this item
    const priceComparison = await aiService.scrapePriceComparison(itemName, user.id);
    
    let message = `🛒 *Checkout - Item ${currentIndex + 1}/${cartItems.length}*\n\n`;
    message += `*${itemName}* (${currentItem.total_quantity} ${currentItem.unit})\n\n`;
    
    // Show available retailers and prices
    const authService = require('../services/authService');
    const userCredentials = await authService.getAllRetailerCredentials(user.id);
    const authenticatedRetailers = userCredentials.map(cred => cred.retailer);
    
    let hasValidPrices = false;
    for (const retailer of authenticatedRetailers) {
      const retailerPrice = priceComparison.find(p => p.retailer.toLowerCase() === retailer);
      if (retailerPrice && retailerPrice.price !== 'N/A') {
        message += `• ${retailer.charAt(0).toUpperCase() + retailer.slice(1)}: ₹${retailerPrice.price} (${retailerPrice.delivery_time})\n`;
        hasValidPrices = true;
      }
    }
    
    if (!hasValidPrices) {
      message += `• No prices available for authenticated retailers\n`;
    }
    
    message += `\n*Select retailer for this item:*\n`;
    for (let i = 0; i < authenticatedRetailers.length; i++) {
      const retailer = authenticatedRetailers[i];
      message += `• '${retailer} for ${itemName}' - Select ${retailer.charAt(0).toUpperCase() + retailer.slice(1)}\n`;
    }
    
    message += `\n*Or:*\n`;
    message += `• 'skip ${itemName}' - Skip this item\n`;
    message += `• 'cancel checkout' - Cancel checkout process`;

    await whatsappService.sendMessage(from, message);

  } catch (error) {
    console.error('❌ Error showing next checkout item:', error);
    throw error;
  }
}

// Show order suggestions for selection
async function showOrderSuggestions(from, user, items) {
  try {
    let message = "🛒 *Product Suggestions:*\n\n";
    
    for (const item of items) {
      const itemName = item.name;
      message += `*${itemName}*\n`;
      
      // Get mixed suggestions from all retailers for this item
      const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
      
      if (mixedSuggestions.length > 0) {
        message += "\n*Best Options (All Retailers):*\n";
        
        mixedSuggestions.forEach((product, index) => {
          const priceDisplay = product.price === 'N/A' ? 'N/A' : `₹${product.price}`;
          const deliveryDisplay = product.delivery_time === 'N/A' ? 'N/A' : product.delivery_time;
          const stockStatus = product.in_stock ? '✅' : '❌ Out of Stock';
          message += `${index + 1}. ${product.name} - ${priceDisplay} (${deliveryDisplay}) ${stockStatus}\n`;
          message += `   📍 ${product.retailer}\n`;
        });
      } else {
        message += "\n*No suggestions available*\n";
      }
      
      message += "\n";
    }

    message += "To select products, reply with:\n";
    message += "• '1 for milk' - Select 1st option for milk\n";
    message += "• '2 for bread' - Select 2nd option for bread\n";
    message += "• 'All 1' - Select 1st option for all items\n";
    message += "• 'Add selected' - Add selected items to cart\n";
    message += "• 'Cancel order' - Cancel this order";

    await whatsappService.sendMessage(from, message);

  } catch (error) {
    console.error('❌ Error showing order suggestions:', error);
    throw error;
  }
}

// Show final checkout cart
async function showFinalCheckoutCart(from, user) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    
    let message = `✅ *Final Checkout Cart*\n\n`;
    let totalAmount = 0;
    
    for (const item of cartItems) {
      if (item.selected_retailer) {
        const itemTotal = item.selected_product_price * item.total_quantity;
        totalAmount += itemTotal;
        
        message += `*${item.product_name}*\n`;
        message += `• ${item.selected_product_name}\n`;
        message += `• Retailer: ${item.selected_retailer}\n`;
        message += `• Price: ₹${item.selected_product_price} × ${item.total_quantity} = ₹${itemTotal}\n`;
        message += `• Delivery: ${item.selected_delivery_time}\n\n`;
      } else {
        message += `*${item.product_name}* - No retailer selected\n\n`;
      }
    }
    
    message += `*Total: ₹${totalAmount}*\n\n`;
    message += `*Actions:*\n`;
    message += `• 'confirm order' - Place your order\n`;
    message += `• 'edit cart' - Go back to item selection\n`;
    message += `• 'cancel order' - Cancel the order`;

    await whatsappService.sendMessage(from, message);

  } catch (error) {
    console.error('❌ Error showing final checkout cart:', error);
    throw error;
  }
}

// Handle phone login method selection
async function handlePhoneLoginMethod(from, user) {
  try {
    console.log(`📱 [PHONE_LOGIN] User ${user.id} selected phone login method`);
    
    // Get current session to retrieve retailer
    const userSession = await userService.getUserSession(user.id);
    
    // Store the login method selection in user session
    await userService.updateUserSession(user.id, { 
      auth_flow: 'phone_login',
      auth_step: 'phone_input',
      retailer: userSession.retailer || 'zepto'
    });
    
    await whatsappService.sendMessage(
      from,
      "📱 *Phone + OTP Login*\n\n" +
      "Enter your phone number:\n" +
      "Format: +91XXXXXXXXXX\n\n" +
      "Example: +919876543210"
    );
    
  } catch (error) {
    console.error('❌ [PHONE_LOGIN] Error handling phone login method:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle email login method selection
async function handleEmailLoginMethod(from, user) {
  try {
    console.log(`📧 [EMAIL_LOGIN] User ${user.id} selected email login method`);
    
    // Store the login method selection in user session
    await userService.updateUserSession(user.id, { 
      auth_flow: 'email_login',
      auth_step: 'email_input'
    });
    
    await whatsappService.sendMessage(
      from,
      "📧 *Email + Password Login*\n\n" +
      "Enter your email address:\n" +
      "Example: user@example.com"
    );
    
  } catch (error) {
    console.error('❌ [EMAIL_LOGIN] Error handling email login method:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle phone number input during authentication
async function handlePhoneNumberInput(from, user, phoneNumber) {
  try {
    console.log(`📱 [PHONE_INPUT] Processing phone number for user ${user.id}: ${phoneNumber}`);
    
    // Validate phone number format
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phoneNumber.replace(/\s/g, ''))) {
      await whatsappService.sendMessage(
        from,
        "❌ Invalid phone number format.\n\n" +
        "Please enter a valid phone number:\n" +
        "Format: +91XXXXXXXXXX\n" +
        "Example: +919876543210"
      );
      return;
    }
    
    // Store phone number in session
    await userService.updateUserSession(user.id, {
      auth_flow: 'phone_login',
      auth_step: 'otp_input',
      phone_number: phoneNumber,
      retailer: user.retailer || 'zepto' // Default to zepto for now
    });
    
    // Send OTP (simulate for now)
    const otp = Math.floor(100000 + Math.random() * 900000); // 6-digit OTP
    
    await whatsappService.sendMessage(
      from,
      `📱 *OTP Sent!*\n\n` +
      `A 6-digit OTP has been sent to ${phoneNumber}\n\n` +
      `Enter the OTP code:`
    );
    
    console.log(`📱 [OTP] Generated OTP for ${phoneNumber}: ${otp}`);
    
  } catch (error) {
    console.error('❌ [PHONE_INPUT] Error handling phone number input:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle OTP input during authentication
async function handleOTPInput(from, user, otpCode) {
  try {
    console.log(`🔐 [OTP_INPUT] Processing OTP for user ${user.id}: ${otpCode}`);
    
    // Validate OTP format
    const otpRegex = /^\d{6}$/;
    if (!otpRegex.test(otpCode)) {
      await whatsappService.sendMessage(
        from,
        "❌ Invalid OTP format.\n\n" +
        "Please enter the 6-digit OTP code:"
      );
      return;
    }
    
    // Get user session to retrieve phone number and retailer
    const userSession = await userService.getUserSession(user.id);
    
    // For now, accept any 6-digit OTP (in real implementation, verify against sent OTP)
    const authService = require('../services/authService');
    const { getRetailerByName } = require('../config/retailers');
    
    const retailer = userSession.retailer || 'zepto';
    const retailerConfig = getRetailerByName(retailer);
    
    // Save credentials (phone number as login_id, OTP as temporary password)
    await authService.saveRetailerCredentials(
      user.id, 
      retailer, 
      userSession.phone_number, 
      `otp_${otpCode}`, // Temporary password
      'phone'
    );
    
    // Clear session completely
    await userService.updateUserSession(user.id, {});
    console.log(`🧹 [SESSION] Cleared session for user ${user.id} after successful authentication`);
    
    // Verify session is cleared
    const clearedSession = await userService.getUserSession(user.id);
    console.log(`🔍 [SESSION] Verified cleared session:`, clearedSession);
    
    await whatsappService.sendMessage(
      from,
      `✅ *Successfully connected to ${retailerConfig.displayName}!*\n\n` +
      `Phone: ${userSession.phone_number}\n` +
      `Login Method: Phone + OTP\n\n` +
      "You can now order items and I'll use your authenticated account for better prices and availability."
    );
    
  } catch (error) {
    console.error('❌ [OTP_INPUT] Error handling OTP input:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle email input during authentication
async function handleEmailInput(from, user, email) {
  try {
    console.log(`📧 [EMAIL_INPUT] Processing email for user ${user.id}: ${email}`);
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      await whatsappService.sendMessage(
        from,
        "❌ Invalid email format.\n\n" +
        "Please enter a valid email address:\n" +
        "Example: user@example.com"
      );
      return;
    }
    
    // Store email in session
    await userService.updateUserSession(user.id, {
      auth_flow: 'email_login',
      auth_step: 'password_input',
      email: email,
      retailer: user.retailer || 'zepto' // Default to zepto for now
    });
    
    await whatsappService.sendMessage(
      from,
      `📧 *Email Verified!*\n\n` +
      `Email: ${email}\n\n` +
      `Now enter your password:`
    );
    
  } catch (error) {
    console.error('❌ [EMAIL_INPUT] Error handling email input:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle password input during authentication
async function handlePasswordInput(from, user, password) {
  try {
    console.log(`🔐 [PASSWORD_INPUT] Processing password for user ${user.id}`);
    
    // Get user session to retrieve email and retailer
    const userSession = await userService.getUserSession(user.id);
    
    const authService = require('../services/authService');
    const { getRetailerByName } = require('../config/retailers');
    
    const retailer = userSession.retailer || 'zepto';
    const retailerConfig = getRetailerByName(retailer);
    
    // Save credentials
    await authService.saveRetailerCredentials(
      user.id, 
      retailer, 
      userSession.email, 
      password,
      'email'
    );
    
    // Clear session completely
    await userService.updateUserSession(user.id, {});
    console.log(`🧹 [SESSION] Cleared session for user ${user.id} after successful authentication`);
    
    // Verify session is cleared
    const clearedSession = await userService.getUserSession(user.id);
    console.log(`🔍 [SESSION] Verified cleared session:`, clearedSession);
    
    await whatsappService.sendMessage(
      from,
      `✅ *Successfully connected to ${retailerConfig.displayName}!*\n\n` +
      `Email: ${userSession.email}\n` +
      `Login Method: Email + Password\n\n` +
      "You can now order items and I'll use your authenticated account for better prices and availability."
    );
    
  } catch (error) {
    console.error('❌ [PASSWORD_INPUT] Error handling password input:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle resend OTP
async function handleResendOTP(from, user) {
  try {
    console.log(`📱 [RESEND_OTP] User ${user.id} requested OTP resend`);
    
    const userSession = await userService.getUserSession(user.id);
    
    if (userSession.auth_flow !== 'phone_login' || userSession.auth_step !== 'otp_input') {
      await whatsappService.sendMessage(
        from,
        "❌ No active OTP request found.\n\n" +
        "Please start the login process again:\n" +
        "'Login Zepto'"
      );
      return;
    }
    
    // Generate new OTP
    const newOtp = Math.floor(100000 + Math.random() * 900000); // 6-digit OTP
    
    await whatsappService.sendMessage(
      from,
      `📱 *New OTP Sent!*\n\n` +
      `A new 6-digit OTP has been sent to ${userSession.phone_number}\n\n` +
      `Enter the OTP code:`
    );
    
    console.log(`📱 [OTP] Generated new OTP for ${userSession.phone_number}: ${newOtp}`);
    
  } catch (error) {
    console.error('❌ [RESEND_OTP] Error handling OTP resend:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle show cart intent
async function handleShowCartIntent(from, user) {
  try {
    const cart = await cartService.getActiveCart(user.id);
    if (!cart) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    const cartItems = await cartService.getCartItemsCombined(cart.id);
    if (cartItems.length === 0) {
      await whatsappService.sendMessage(
        from,
        "🛒 Your cart is empty.\n\nStart by saying 'Order [items]'"
      );
      return;
    }

    let message = "🛒 *Your Cart:*\n\n";
    
    for (const item of cartItems) {
      message += `• ${item.product_name} - ${item.total_quantity} ${item.unit}\n`;
    }

    message += "\nTo add more items, say 'Add [item name]'\n";
    message += "To see prices, say 'Show prices'\n";
    message += "To checkout, say 'Checkout'";

    await whatsappService.sendMessage(from, message);

  } catch (error) {
    console.error('❌ Error handling show cart intent:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error showing your cart. Please try again."
    );
  }
}

// Handle location messages from WhatsApp
async function handleLocationMessage(from, user, message, messageSid) {
  try {
    console.log(`📍 Processing location message from ${from}`);
    
    // Parse location data from WhatsApp
    let locationData;
    try {
      locationData = JSON.parse(message);
    } catch (error) {
      console.error('❌ Failed to parse location JSON:', error);
      await whatsappService.sendMessage(
        from,
        "❌ Sorry, I couldn't read your location. Please try sharing it again or type your address manually."
      );
      return;
    }

    // Extract coordinates
    const { latitude, longitude } = locationData;
    if (!latitude || !longitude) {
      await whatsappService.sendMessage(
        from,
        "❌ Location data incomplete. Please try sharing your location again."
      );
      return;
    }

    console.log(`📍 Location received: ${latitude}, ${longitude}`);

    // Reverse geocode to get address
    const address = await aiService.reverseGeocode(latitude, longitude);
    if (!address) {
      await whatsappService.sendMessage(
        from,
        "❌ Couldn't find address for this location. Please type your address manually."
      );
      return;
    }

    // Save the address
    await userService.saveAddress(user.id, address);
    
    // Ask for confirmation
    await sendAddressConfirmation(from, address);

  } catch (error) {
    console.error('❌ Error handling location message:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error processing your location. Please try typing your address manually."
    );
  }
}

// Handle product selection from suggestions
async function handleProductSelection(from, user, parsedIntent) {
  try {
    console.log(`🛒 [PRODUCT_SELECTION] Processing product selection for user ${user.id}`);
    
    const { selectionNumber, itemName, selectAll } = parsedIntent;
    
    if (!selectionNumber || selectionNumber < 1) {
      await whatsappService.sendMessage(
        from,
        "❌ Invalid selection number. Please choose a number from the suggestions."
      );
      return;
    }

    // Check if user is in order mode or checkout mode
    const userSession = await userService.getUserSession(user.id);
    
    if (userSession.order_mode) {
      // Handle order mode product selection
      await handleOrderModeProductSelection(from, user, parsedIntent);
    } else {
      // Handle regular cart product selection
      const cart = await cartService.getActiveCart(user.id);
      if (!cart) {
        await whatsappService.sendMessage(
          from,
          "🛒 You don't have an active cart. Start by saying 'Order [items]'"
        );
        return;
      }

      const productSuggestions = await cartService.getProductSuggestions(cart.id, user.id);
      
      if (selectAll) {
        await handleAllProductSelection(from, user, cart, productSuggestions, selectionNumber);
      } else {
        await handleSingleProductSelection(from, user, cart, productSuggestions, itemName, selectionNumber);
      }
    }

  } catch (error) {
    console.error('❌ [PRODUCT_SELECTION] Error handling product selection:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error processing your selection. Please try again."
    );
  }
}

// Handle single product selection
async function handleSingleProductSelection(from, user, cart, productSuggestions, itemName, selectionNumber) {
  try {
    const itemSuggestions = productSuggestions[itemName];
    if (!itemSuggestions) {
      await whatsappService.sendMessage(
        from,
        `❌ No suggestions found for "${itemName}". Please try again.`
      );
      return;
    }

    // Get mixed suggestions for this item
    const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
    
    if (selectionNumber > mixedSuggestions.length) {
      await whatsappService.sendMessage(
        from,
        `❌ Invalid selection. Only ${mixedSuggestions.length} options available for "${itemName}".`
      );
      return;
    }

    const selectedProduct = mixedSuggestions[selectionNumber - 1];
    
    // Update cart item with selected product details
    await cartService.updateCartItemWithProduct(cart.id, itemName, selectedProduct);
    
    await whatsappService.sendMessage(
      from,
      `✅ Selected for ${itemName}:\n\n` +
      `• ${selectedProduct.name}\n` +
      `• Price: ₹${selectedProduct.price}\n` +
      `• Retailer: ${selectedProduct.retailer}\n` +
      `• Delivery: ${selectedProduct.delivery_time}\n\n` +
      `Continue selecting other items or say 'Show cart' to view your selections.`
    );

  } catch (error) {
    console.error('❌ Error handling single product selection:', error);
    throw error;
  }
}

// Handle all product selection
async function handleAllProductSelection(from, user, cart, productSuggestions, selectionNumber) {
  try {
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    let selectedCount = 0;
    
    for (const item of cartItems) {
      const itemName = item.product_name;
      const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
      
      if (selectionNumber <= mixedSuggestions.length) {
        const selectedProduct = mixedSuggestions[selectionNumber - 1];
        await cartService.updateCartItemWithProduct(cart.id, itemName, selectedProduct);
        selectedCount++;
      }
    }
    
    await whatsappService.sendMessage(
      from,
      `✅ Selected option ${selectionNumber} for ${selectedCount} items.\n\n` +
      `Say 'Show cart' to view your selections or continue selecting individual items.`
    );

  } catch (error) {
    console.error('❌ Error handling all product selection:', error);
    throw error;
  }
}

// Handle retailer selection for checkout
async function handleRetailerSelectionForCheckout(from, user, retailer, itemName) {
  try {
    console.log(`🛒 [CHECKOUT] User ${user.id} selected ${retailer} for ${itemName}`);
    
    const userSession = await userService.getUserSession(user.id);
    if (!userSession.checkout_mode) {
      await whatsappService.sendMessage(from, "❌ No active checkout session. Say 'checkout' to start.");
      return;
    }

    // Get price comparison for this item
    const priceComparison = await aiService.scrapePriceComparison(itemName, user.id);
    const retailerPrice = priceComparison.find(p => p.retailer.toLowerCase() === retailer);
    
    if (!retailerPrice || retailerPrice.price === 'N/A') {
      await whatsappService.sendMessage(
        from,
        `❌ No price available for ${retailer} for ${itemName}. Please select another retailer.`
      );
      return;
    }

    // Update cart item with selected retailer
    const cart = await cartService.getActiveCart(user.id);
    await cartService.updateCartItemWithRetailer(cart.id, itemName, retailer, retailerPrice);
    
    await whatsappService.sendMessage(
      from,
      `✅ Selected ${retailer.charAt(0).toUpperCase() + retailer.slice(1)} for ${itemName}\n` +
      `Price: ₹${retailerPrice.price}\n` +
      `Delivery: ${retailerPrice.delivery_time}`
    );

    // Move to next item
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    const currentIndex = userSession.checkout_current_item || 0;
    const nextIndex = currentIndex + 1;
    
    await userService.updateUserSession(user.id, {
      ...userSession,
      checkout_current_item: nextIndex
    });

    await showNextCheckoutItem(from, user, cartItems, nextIndex);

  } catch (error) {
    console.error('❌ Error handling retailer selection for checkout:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle skip item
async function handleSkipItem(from, user, itemName) {
  try {
    console.log(`🛒 [CHECKOUT] User ${user.id} skipped ${itemName}`);
    
    const userSession = await userService.getUserSession(user.id);
    if (!userSession.checkout_mode) {
      await whatsappService.sendMessage(from, "❌ No active checkout session. Say 'checkout' to start.");
      return;
    }

    await whatsappService.sendMessage(
      from,
      `⏭️ Skipped ${itemName}. Moving to next item...`
    );

    // Move to next item
    const cart = await cartService.getActiveCart(user.id);
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    const currentIndex = userSession.checkout_current_item || 0;
    const nextIndex = currentIndex + 1;
    
    await userService.updateUserSession(user.id, {
      ...userSession,
      checkout_current_item: nextIndex
    });

    await showNextCheckoutItem(from, user, cartItems, nextIndex);

  } catch (error) {
    console.error('❌ Error handling skip item:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle confirm order
async function handleConfirmOrder(from, user) {
  try {
    console.log(`🛒 [ORDER] User ${user.id} confirmed order`);
    
    const cart = await cartService.getActiveCart(user.id);
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    
    // Generate deep links for each retailer
    const retailerCarts = {};
    for (const item of cartItems) {
      if (item.selected_retailer) {
        if (!retailerCarts[item.selected_retailer]) {
          retailerCarts[item.selected_retailer] = [];
        }
        retailerCarts[item.selected_retailer].push(item);
      }
    }
    
    let message = `🎉 *Order Confirmed!*\n\n`;
    message += `Here are your checkout links:\n\n`;
    
    for (const [retailer, items] of Object.entries(retailerCarts)) {
      const total = items.reduce((sum, item) => sum + (item.selected_product_price * item.total_quantity), 0);
      message += `*${retailer.charAt(0).toUpperCase() + retailer.slice(1)} Cart:*\n`;
      message += `Total: ₹${total}\n`;
      message += `Items: ${items.length}\n`;
      message += `🔗 [Checkout on ${retailer.charAt(0).toUpperCase() + retailer.slice(1)}](https://${retailer}.com/checkout)\n\n`;
    }
    
    // Clear checkout session
    await userService.updateUserSession(user.id, {});
    
    await whatsappService.sendMessage(from, message);

  } catch (error) {
    console.error('❌ Error handling confirm order:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle edit cart
async function handleEditCart(from, user) {
  try {
    console.log(`🛒 [CHECKOUT] User ${user.id} wants to edit cart`);
    
    const userSession = await userService.getUserSession(user.id);
    if (!userSession.checkout_mode) {
      await whatsappService.sendMessage(from, "❌ No active checkout session. Say 'checkout' to start.");
      return;
    }

    // Reset to first item
    await userService.updateUserSession(user.id, {
      ...userSession,
      checkout_current_item: 0
    });

    const cart = await cartService.getActiveCart(user.id);
    const cartItems = await cartService.getCartItemsCombined(cart.id);
    
    await showNextCheckoutItem(from, user, cartItems, 0);

  } catch (error) {
    console.error('❌ Error handling edit cart:', error);
    await whatsappService.sendMessage(from, "😔 Sorry, I encountered an error. Please try again.");
  }
}

// Handle order mode product selection
async function handleOrderModeProductSelection(from, user, parsedIntent) {
  try {
    const { selectionNumber, itemName, selectAll } = parsedIntent;
    const userSession = await userService.getUserSession(user.id);
    
    if (selectAll) {
      // Handle "all X" selection for order mode
      const orderItems = userSession.order_items || [];
      const selectedItems = [];
      
      for (const item of orderItems) {
        const mixedSuggestions = await cartService.getMixedProductSuggestions(item.name, user.id);
        if (selectionNumber <= mixedSuggestions.length) {
          const selectedProduct = mixedSuggestions[selectionNumber - 1];
          selectedItems.push({
            ...item,
            selectedProduct
          });
        }
      }
      
      // Store selected items in session
      await userService.updateUserSession(user.id, {
        ...userSession,
        selected_order_items: selectedItems
      });
      
      await whatsappService.sendMessage(
        from,
        `✅ Selected option ${selectionNumber} for ${selectedItems.length} items.\n\n` +
        `Say 'Add selected' to add these items to your cart.`
      );
      
    } else {
      // Handle single item selection for order mode
      const mixedSuggestions = await cartService.getMixedProductSuggestions(itemName, user.id);
      
      if (selectionNumber > mixedSuggestions.length) {
        await whatsappService.sendMessage(
          from,
          `❌ Invalid selection. Only ${mixedSuggestions.length} options available for "${itemName}".`
        );
        return;
      }

      const selectedProduct = mixedSuggestions[selectionNumber - 1];
      const orderItems = userSession.order_items || [];
      const selectedItems = userSession.selected_order_items || [];
      
      // Update or add selected item
      const existingIndex = selectedItems.findIndex(item => item.name === itemName);
      if (existingIndex >= 0) {
        selectedItems[existingIndex] = {
          ...orderItems.find(item => item.name === itemName),
          selectedProduct
        };
      } else {
        selectedItems.push({
          ...orderItems.find(item => item.name === itemName),
          selectedProduct
        });
      }
      
      // Store selected items in session
      await userService.updateUserSession(user.id, {
        ...userSession,
        selected_order_items: selectedItems
      });
      
      await whatsappService.sendMessage(
        from,
        `✅ Selected for ${itemName}:\n\n` +
        `• ${selectedProduct.name}\n` +
        `• Price: ₹${selectedProduct.price}\n` +
        `• Retailer: ${selectedProduct.retailer}\n` +
        `• Delivery: ${selectedProduct.delivery_time}\n\n` +
        `Continue selecting other items or say 'Add selected' to add to cart.`
      );
    }

  } catch (error) {
    console.error('❌ Error handling order mode product selection:', error);
    throw error;
  }
}

// Handle adding selected items to cart
async function handleAddSelectedToCart(from, user) {
  try {
    const userSession = await userService.getUserSession(user.id);
    
    if (!userSession.order_mode || !userSession.selected_order_items) {
      await whatsappService.sendMessage(
        from,
        "❌ No items selected. Please select products first."
      );
      return;
    }

    const selectedItems = userSession.selected_order_items;
    const cartId = userSession.order_cart_id;
    
    if (!cartId) {
      await whatsappService.sendMessage(
        from,
        "❌ No active cart found. Please try ordering again."
      );
      return;
    }

    // Add selected items to cart
    const addedItems = [];
    for (const item of selectedItems) {
      if (item.selectedProduct) {
        // Add item with selected product details
        await cartService.addItemToCartWithProduct(cartId, item, item.selectedProduct);
        addedItems.push(`${item.quantity} ${item.unit} ${item.name} (${item.selectedProduct.name})`);
      } else {
        // Add item without product selection
        await cartService.addItemToCart(cartId, item);
        addedItems.push(`${item.quantity} ${item.unit} ${item.name}`);
      }
    }

    // Clear order mode session
    await userService.updateUserSession(user.id, {});

    await whatsappService.sendMessage(
      from,
      `✅ Added to your cart:\n${addedItems.map(item => `• ${item}`).join('\n')}\n\n` +
      `Type 'show cart' to see your current items or 'checkout' to start checkout.`
    );

  } catch (error) {
    console.error('❌ Error adding selected items to cart:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error adding items to cart. Please try again."
    );
  }
}

module.exports = router; 