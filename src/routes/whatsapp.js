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
    } else if (parsedIntent.intent === 'show_cart') {
      await handleShowCartIntent(from, user);
    } else if (parsedIntent.intent === 'address_confirmation') {
      await handleAddressConfirmation(from, user, parsedIntent);
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

    // Get price comparisons
    const priceComparisons = await cartService.getPriceComparisons(cart.id);
    
    // Send price comparison message
    await sendPriceComparison(from, priceComparisons);

  } catch (error) {
    console.error('❌ Error handling order intent:', error);
    throw error;
  }
}

// Handle add item intent
async function handleAddItemIntent(from, user, parsedIntent) {
  try {
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

  } catch (error) {
    console.error('❌ Error handling add item intent:', error);
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

// Send price comparison
async function sendPriceComparison(from, comparisons) {
  let message = "🛒 *Price Comparison:*\n\n";
  
  for (const item of comparisons) {
    const itemName = item.name || item.product_name || 'Unknown Item';
    message += `*${itemName}*\n`;
    for (const price of item.prices) {
      message += `➕ ${price.retailer}: ₹${price.price} (${price.delivery_time})\n`;
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