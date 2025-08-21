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

    // Check for special commands
    if (message.toLowerCase().includes('help') || message.toLowerCase().includes('start')) {
      await sendHelpMessage(from);
      return;
    }

    if (message.toLowerCase().includes('stop') || message.toLowerCase().includes('unsubscribe')) {
      await userService.updateUserAllowed(user.id, false);
      await whatsappService.sendMessage(
        from,
        "👋 You've been unsubscribed from ShopGenie AI. Send 'start' to re-enable."
      );
      return;
    }

    // Check for show cart command (direct check)
    if (message.toLowerCase().includes('show cart') || message.toLowerCase().includes('view cart')) {
      await handleShowCartIntent(from, user);
      return;
    }

    // Check for connected retailers command
    if (message.toLowerCase().includes('connected retailers') || message.toLowerCase().includes('show connected') || message.toLowerCase().includes('my retailers')) {
      await handleShowConnectedRetailers(from, user);
      return;
    }

    // Handle location messages
    if (messageType === 'application/vnd.geo+json' || messageType === 'location') {
      await handleLocationMessage(from, user, message, messageSid);
      return;
    }

    // Use AI to parse the message
    const parsedIntent = await aiService.parseMessage(message);
    
    if (parsedIntent.intent === 'order') {
      await handleOrderIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'add_item') {
      await handleAddItemIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'remove_item') {
      await handleRemoveItemIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'show_prices') {
      await handleShowPricesIntent(from, user);
    } else if (parsedIntent.intent === 'show_cart') {
      await handleShowCartIntent(from, user);
    } else if (parsedIntent.intent === 'address_confirmation') {
      await handleAddressConfirmation(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'authentication') {
      await handleAuthenticationIntent(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'credential_input') {
      await handleCredentialInput(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'product_selection') {
      await handleProductSelection(from, user, parsedIntent);
    } else if (parsedIntent.intent === 'retailer_selection') {
      await handleRetailerSelection(from, user, parsedIntent);
    } else {
      await whatsappService.sendMessage(
        from,
        "🤔 I didn't understand that. Try saying:\n\n'Order milk and bread to 123 Main St, Bangalore'\n\nOr type 'help' for more options."
      );
    }

  } catch (error) {
    console.error('❌ Error processing message:', error);
    await whatsappService.sendMessage(
      from,
      "😔 Sorry, I encountered an error. Please try again or type 'help' for assistance."
    );
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

    // Add items to cart with proper duplicate handling
    await cartService.addItemsToCart(cart.id, parsedIntent.items);

    // Get product suggestions
    const productSuggestions = await cartService.getProductSuggestions(cart.id, user.id);
    
    // Send product suggestions message
    await sendProductSuggestions(from, productSuggestions);

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
    await sendProductSuggestions(from, productSuggestions);

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
async function sendProductSuggestions(from, suggestions) {
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

    // Start authentication flow
    const loginMethods = retailerConfig.loginMethods.join(' or ');
    await whatsappService.sendMessage(
      from,
      `🔐 Let's connect your ${retailerConfig.displayName} account!\n\n` +
      `Send your ${retailerConfig.displayName} login details in this format:\n` +
      `'${retailer} ${loginMethods} password'\n\n` +
      "Examples:\n" +
      `• '${retailer} user@example.com password123'\n` +
      `• '${retailer} +919876543210 password123'\n\n` +
      "Your password will be encrypted and stored securely."
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

module.exports = router; 